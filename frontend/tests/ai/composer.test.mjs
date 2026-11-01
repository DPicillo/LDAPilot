// Composer and settings helpers (lib/aiComposer.ts, lib/aiSettings.ts) and
// the live egress action of the reducer (A-08, A-14, A-15, A-32, A-33, A-35).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModelId, droppedNames, soleModel, stripBareAt } from '../../src/lib/aiComposer.ts';
import { discoveryNeedsKey, mergeSettingsDraft, reloadSettingsDraft } from '../../src/lib/aiSettings.ts';
import { initialState, reduce } from '../../src/lib/aiReducer.ts';

test('a bare "@" is never sent', () => {
  assert.equal(stripBareAt('@'), '');
  assert.equal(stripBareAt('  @  '), '');
  assert.equal(stripBareAt('who is @'), 'who is');
  assert.equal(stripBareAt('mail me@x.org please'), 'mail me@x.org please');
  assert.equal(stripBareAt('@anna is locked'), '@anna is locked');
  assert.equal(stripBareAt('a @ b'), 'a  b');
});

const models = [{ id: 'qwen3-vl:8b', tools: 'yes' }, { id: 'llama3:latest', tools: 'yes' }, { id: 'nomic-embed-text:latest', tools: 'no' }];

test('/model names are checked against the discovered models', () => {
  assert.deepEqual(checkModelId('qwen3-vl:8b', models, 'builtin'), { ok: true, id: 'qwen3-vl:8b' });
  assert.deepEqual(checkModelId('QWEN3-VL:8B', models, 'builtin'), { ok: true, id: 'qwen3-vl:8b' });
  assert.deepEqual(checkModelId('llama3', models, 'builtin'), { ok: true, id: 'llama3:latest' });
  const bad = checkModelId('gpt-nonexistent', models, 'builtin');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.suggestions, ['qwen3-vl:8b', 'llama3:latest', 'nomic-embed-text:latest']);
  assert.deepEqual(checkModelId('qwen3', models, 'builtin'), { ok: false, suggestions: ['qwen3-vl:8b'] });
  assert.deepEqual(checkModelId('x', [], 'builtin'), { ok: 'unknown', id: 'x' });
  assert.deepEqual(checkModelId('claude-opus-4-5-20251101', [{ id: 'opus' }], 'claudecode'), { ok: true, id: 'claude-opus-4-5-20251101' });
});

test('the only (tool-capable) model is preselected', () => {
  assert.equal(soleModel([{ id: 'qwen3-vl:8b', tools: 'yes' }]), 'qwen3-vl:8b');
  assert.equal(soleModel([{ id: 'a', tools: 'yes' }, { id: 'embed', tools: 'no' }]), 'a');
  assert.equal(soleModel(models), null);
  assert.equal(soleModel([]), null);
  assert.equal(soleModel(null), null);
});

test('dropped Ask AI entries are named', () => {
  assert.equal(droppedNames(['a', 'b', 'c', 'd', 'e', 'Test Smartcard', 'Test Stale'], 5), 'Test Smartcard, Test Stale');
  assert.equal(droppedNames(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], 5), '6, 7, 8 and 2 more');
});

test('model discovery waits for a key where the provider needs one', () => {
  assert.equal(discoveryNeedsKey({ engine: 'builtin', provider: 'openai', flavor: 'openai' }, false), true);
  assert.equal(discoveryNeedsKey({ engine: 'builtin', provider: 'anthropic', flavor: '' }, false), true);
  assert.equal(discoveryNeedsKey({ engine: 'builtin', provider: 'openai', flavor: 'openai' }, true), false);
  assert.equal(discoveryNeedsKey({ engine: 'builtin', provider: 'ollama', flavor: '' }, false), false);
  assert.equal(discoveryNeedsKey({ engine: 'builtin', provider: 'openai', flavor: 'litellm' }, false), false);
});

test('reloading settings changed elsewhere keeps the unsaved changes', () => {
  const base = { revision: 3, model: 'a', maxSteps: 12, connectionAccess: { p1: { level: 'ask' }, p2: { level: 'read' } }, connectionNotes: {}, claudeCode: { model: '' }, hasKey: true };
  const draft = { ...base, maxSteps: 20, connectionAccess: { p1: { level: 'write' }, p2: { level: 'read' } }, connectionNotes: { p2: 'only OU=Sandbox' } };
  const fresh = { ...base, revision: 4, model: 'b', connectionAccess: { p1: { level: 'ask' }, p2: { level: 'read', hosts: ['api.x'] }, p3: { level: 'read' } } };
  const m = mergeSettingsDraft(base, draft, fresh);
  assert.equal(m.revision, 4);
  assert.equal(m.model, 'b'); // changed elsewhere, not in the draft
  assert.equal(m.maxSteps, 20); // the draft's change
  assert.deepEqual(m.connectionAccess, { p1: { level: 'write' }, p2: { level: 'read', hosts: ['api.x'] }, p3: { level: 'read' } });
  assert.deepEqual(m.connectionNotes, { p2: 'only OU=Sandbox' });
});

test('Reload merges against the config the draft started from (P2)', () => {
  // Draft opened at revision 3 (DS = ask), default access changed to none; then
  // "Always allow read" in a chat saved DS = read (revision 4) and the ai:config
  // event already put revision 4 into the store.
  const base = { revision: 3, defaultAccess: 'ask', connectionAccess: { ds: { level: 'ask' } }, connectionNotes: {}, claudeCode: {} };
  const draft = { ...base, defaultAccess: 'none' };
  const fresh = { ...base, revision: 4, connectionAccess: { ds: { level: 'read' } } };
  const r = reloadSettingsDraft(draft, base, fresh, fresh);
  assert.equal(r.draft.defaultAccess, 'none'); // the user's change
  assert.deepEqual(r.draft.connectionAccess, { ds: { level: 'read' } }); // the grant survives
  assert.equal(r.draft.revision, 4);
  assert.equal(r.base, fresh);
  // The old behaviour (store config as base) undid the grant:
  assert.deepEqual(mergeSettingsDraft(fresh, draft, fresh).connectionAccess, { ds: { level: 'ask' } });
  // Without a recorded base the saved config stands in.
  assert.equal(reloadSettingsDraft(draft, undefined, base, fresh).draft.connectionAccess.ds.level, 'read');
});

test('local/egress updates the chat info ledger of a loaded chat only', () => {
  const CHAT = '11111111-1111-4111-8111-111111111111';
  const view = { id: CHAT, title: 'Chat', createdAt: 1, updatedAt: 1, messageCount: 0, model: '', running: false, corrupt: false, pendingWrite: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    modelOverride: '', messages: [], compactions: [], egress: [], readOnly: false };
  let s = reduce(initialState(), { name: 'local/chat_loaded', payload: { view } });
  const rec = { profileId: 'p1', providerHost: 'localhost', remote: false, toolResults: 2, bytes: 1200, firstAt: 1, lastAt: 2 };
  s = reduce(s, { name: 'local/egress', payload: { chatId: CHAT, egress: [rec] } });
  assert.deepEqual(s.chatMeta[CHAT].egress, [rec]);
  const same = reduce(s, { name: 'local/egress', payload: { chatId: 'other', egress: [rec] } });
  assert.equal(same, s);
});
