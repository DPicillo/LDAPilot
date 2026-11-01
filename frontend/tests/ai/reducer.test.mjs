// Reducer tests (§12.10). Run from frontend/: node --test tests/ai/
// Node >= 22.18 strips the TypeScript types of the imported module; no test
// framework is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  heldCount,
  initialState,
  isRunEvent,
  mergeTail,
  pendingApprovals,
  reduce,
  reduceApplied,
  regKey,
  runActive,
  selectPendingApprovalCount,
} from '../../src/lib/aiReducer.ts';

const CHAT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const env = (seq, over = {}) => ({ chatId: CHAT, runId: RUN, seq, ts: 1000 + seq, ...over });
const ev = (name, payload) => ({ name, payload });
const apply = (s, ...actions) => actions.reduce((acc, a) => reduce(acc, a), s);

function summary(id = CHAT) {
  return {
    id, title: 'Chat', createdAt: 1, updatedAt: 1, messageCount: 0, model: '', running: false, corrupt: false, pendingWrite: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  };
}

function msg(id, role, text, over = {}) {
  return { id, role, createdAt: 1, blocks: [{ type: 'text', text }], ...over };
}

function chatView(messages) {
  return { ...summary(), modelOverride: '', messages, compactions: [], egress: [], readOnly: false };
}

function started(seq = 1, over = {}) {
  return ev('ai:run_started', {
    ...env(seq, over), userMessageId: 'u1', kind: 'send', engine: 'builtin', provider: 'ollama', model: 'qwen3-vl:8b', startedAt: 1000,
  });
}

function loaded(messages = [msg('u0', 'user', 'hi'), msg('a0', 'assistant', 'hello')]) {
  return reduce(initialState(), { name: 'local/chat_loaded', payload: { view: chatView(messages) } });
}

function approvalRequest(seq, approvalId, toolCallId, over = {}) {
  return ev('ai:approval_request', {
    ...env(seq), approvalId, toolCallId, kind: 'write', tool: 'modify_entry', toolDisplayName: 'Modify entry',
    connection: { profileId: 'p1', label: 'Lab', serverType: 'ad', host: 'dc1', identity: 'Administrator', readOnly: false, localProvider: true },
    position: { index: 1, total: 2 }, allowedDecisions: ['approve', 'deny', 'deny_remaining'], requireConfirm: false, expiresAt: 999999, ...over,
  });
}

function toolStart(seq, toolCallId, over = {}) {
  return ev('ai:tool_start', {
    ...env(seq), messageId: 'm1', toolCallId, name: 'search_ldap', displayName: 'Search', kind: 'read', args: '{"filter":"(cn=x)"}',
    connectionId: 'p1', connectionLabel: 'Lab', status: 'running', warnings: null, ...over,
  });
}

// --- run and seq rules (§3.5) -------------------------------------------------

test('events before ai:run_started are dropped', () => {
  const s = apply(loaded(), ev('ai:text_delta', { ...env(1), messageId: 'm1', blockIndex: 0, text: 'x' }));
  assert.equal(s.runs[CHAT], undefined);
});

test('run_started creates the run, marks the chat running and takes the pending base', () => {
  let s = loaded();
  s = reduce(s, { name: 'local/chats', payload: { chats: [summary()] } });
  s = reduce(s, { name: 'local/pending_send', payload: { chatId: CHAT, tempId: 'local-1', kind: 'send', text: 'q', now: 5, baseMessageId: 'a0' } });
  s = reduce(s, started(1));
  const r = s.runs[CHAT];
  assert.equal(r.runId, RUN);
  assert.equal(r.lastSeq, 1);
  assert.equal(r.baseMessageId, 'a0');
  assert.equal(r.status, 'running');
  assert.ok(runActive(r));
  assert.equal(s.chats[0].running, true);
});

test('events of another run are held, a stale seq or a duplicate are dropped', () => {
  let s = apply(loaded(), started(1), ev('ai:message_started', { ...env(2), messageId: 'm1', step: 1 }));
  const before = s;
  // An unknown run may be one whose run_started is still on its way: held, not applied.
  s = reduce(s, ev('ai:text_delta', { ...env(3, { runId: RUN2 }), messageId: 'm1', blockIndex: 0, text: 'other run' }));
  assert.equal(s.runs, before.runs, 'other run not applied');
  assert.equal(heldCount(s, CHAT), 1);
  s = before;
  s = reduce(s, ev('ai:text_delta', { ...env(2), messageId: 'm1', blockIndex: 0, text: 'stale' }));
  assert.equal(s, before, 'seq <= lastSeq');
  s = reduce(s, ev('ai:text_delta', { ...env(3), messageId: 'm1', blockIndex: 0, text: 'ok' }));
  assert.equal(s.runs[CHAT].liveMessages[0].blocks[0].text, 'ok');
  assert.equal(s.runs[CHAT].lastSeq, 3);
  assert.equal(reduce(s, ev('ai:text_delta', { ...env(3), messageId: 'm1', blockIndex: 0, text: 'dup' })), s, 'duplicate');
});

test('a new run_started resets lastSeq and replaces the previous run', () => {
  let s = apply(loaded(), started(1), ev('ai:message_started', { ...env(2), messageId: 'm1', step: 1 }),
    ev('ai:done', { ...env(3), status: 'completed', durationMs: 5, totals: {}, canContinue: false, contextEdited: false }));
  s = reduce(s, started(1, { runId: RUN2 }));
  assert.equal(s.runs[CHAT].runId, RUN2);
  assert.equal(s.runs[CHAT].lastSeq, 1);
  assert.equal(s.runs[CHAT].liveMessages.length, 0);
  // the old run's late events no longer apply
  const after = reduce(s, ev('ai:text_delta', { ...env(9), messageId: 'm1', blockIndex: 0, text: 'late' }));
  assert.equal(after, s);
});

test('a replayed run_started of the current run is ignored', () => {
  const s = apply(loaded(), started(1), ev('ai:message_started', { ...env(2), messageId: 'm1', step: 1 }));
  assert.equal(reduce(s, started(1)), s);
});

test('runs of different chats are independent', () => {
  let s = apply(loaded(), started(1), started(1, { chatId: OTHER, runId: RUN2 }));
  s = reduce(s, ev('ai:text_delta', { ...env(2, { chatId: OTHER, runId: RUN2 }), messageId: 'mo', blockIndex: 0, text: 'B' }));
  s = reduce(s, ev('ai:text_delta', { ...env(2), messageId: 'm1', blockIndex: 0, text: 'A' }));
  assert.equal(s.runs[CHAT].liveMessages[0].blocks[0].text, 'A');
  assert.equal(s.runs[OTHER].liveMessages[0].blocks[0].text, 'B');
});

test('events without a run bypass the run rules', () => {
  let s = apply(loaded(), started(5));
  s = reduce(s, { name: 'local/chats', payload: { chats: [summary()] } });
  s = reduce(s, ev('ai:chat_updated', { chatId: CHAT, title: 'Locked accounts', updatedAt: 50, pendingWrite: true }));
  assert.equal(s.chats[0].title, 'Locked accounts');
  assert.equal(s.chats[0].pendingWrite, true);
  s = reduce(s, ev('ai:config_updated', { revision: 7 }));
  s = reduce(s, ev('ai:config_updated', { revision: 3 }));
  assert.equal(s.remoteConfigRevision, 7, 'an older revision never lowers it');
  // test-1 D3: config_updated and chat_updated reach the store's side
  // effects (config reload, chat list reload for unknown chats).
  const cu = reduceApplied(s, ev('ai:config_updated', { revision: 8 }));
  assert.deepEqual(cu.applied.map((e) => e.name), ['ai:config_updated']);
  assert.equal(reduceApplied(s, ev('ai:chat_updated', { chatId: 'unknown', updatedAt: 1 })).applied.length, 1);
  s = reduce(s, ev('ai:grants_updated', { chatId: CHAT, grants: [{ id: 'g1', tool: 'modify_entry', profileId: 'p1', connectionLabel: 'Lab', scope: 'description below OU=X', dns: null, subtree: 'OU=X', attributes: ['description'], usesLeft: 5, expiresAt: 99 }] }));
  assert.equal(s.grants[CHAT].length, 1);
  s = reduce(s, ev('ai:grants_updated', { chatId: CHAT, grants: null }));
  assert.deepEqual(s.grants[CHAT], []);
  s = reduce(s, ev('ai:models_updated', { providerKey: 'ollama', models: [], discovery: { provider: 'ollama', baseUrl: 'u', models: [], fetchedAt: 1, fromCache: false } }));
  assert.equal(s.models.ollama.baseUrl, 'u');
  assert.equal(s.runs[CHAT].lastSeq, 5, 'run state untouched');
});

// --- streaming ------------------------------------------------------------------

test('text and thinking deltas build blocks; text_replaced replaces the block text', () => {
  let s = apply(loaded(), started(1),
    ev('ai:message_started', { ...env(2), messageId: 'm1', step: 1, model: 'haiku' }),
    ev('ai:thinking_delta', { ...env(3), messageId: 'm1', blockIndex: 0, text: 'Let me ' }),
    ev('ai:thinking_delta', { ...env(4), messageId: 'm1', blockIndex: 0, text: 'think.' }),
    ev('ai:text_delta', { ...env(5), messageId: 'm1', blockIndex: 1, text: 'Hello ' }),
    ev('ai:text_delta', { ...env(6), messageId: 'm1', blockIndex: 1, text: '<tool_call>{…}' }));
  let m = s.runs[CHAT].liveMessages[0];
  assert.equal(m.model, 'haiku');
  assert.equal(m.blocks[0].type, 'thinking');
  assert.equal(m.blocks[0].text, 'Let me think.');
  assert.equal(m.blocks[0].startedAt, 1003);
  assert.equal(m.blocks[0].updatedAt, 1004);
  assert.equal(m.blocks[1].text, 'Hello <tool_call>{…}');
  s = reduce(s, ev('ai:text_replaced', { ...env(7), messageId: 'm1', blockIndex: 1, text: 'Hello ' }));
  m = s.runs[CHAT].liveMessages[0];
  assert.equal(m.blocks[1].text, 'Hello ');
  assert.equal(m.blocks[0].text, 'Let me think.', 'other blocks untouched');
});

test('a delta for an unknown message starts it (re-sync tolerance)', () => {
  const s = apply(loaded(), started(1), ev('ai:text_delta', { ...env(2), messageId: 'mx', blockIndex: 2, text: 'x' }));
  const m = s.runs[CHAT].liveMessages[0];
  assert.equal(m.id, 'mx');
  assert.equal(m.blocks.length, 3);
  assert.equal(m.blocks[0], null);
  assert.equal(m.blocks[2].text, 'x');
});

test('step_discarded drops only that step', () => {
  const s = apply(loaded(), started(1),
    ev('ai:message_started', { ...env(2), messageId: 'm1', step: 1 }),
    ev('ai:text_delta', { ...env(3), messageId: 'm1', blockIndex: 0, text: 'keep' }),
    ev('ai:message_started', { ...env(4), messageId: 'm2', step: 2 }),
    ev('ai:text_delta', { ...env(5), messageId: 'm2', blockIndex: 0, text: 'cut off…' }),
    ev('ai:step_discarded', { ...env(6), messageId: 'm2', reason: 'max_tokens_retry' }),
    ev('ai:message_started', { ...env(7), messageId: 'm3', step: 2 }));
  assert.deepEqual(s.runs[CHAT].liveMessages.map((m) => m.id), ['m1', 'm3']);
});

test('a status line is kept until new content arrives; warnings are collected once', () => {
  let s = apply(loaded(), started(1),
    ev('ai:status', { ...env(2), kind: 'model_loading', message: 'Loading the model…' }),
    ev('ai:status', { ...env(3), kind: 'warning', message: 'Rate limit soon' }),
    ev('ai:status', { ...env(4), kind: 'warning', message: 'Rate limit soon' }));
  assert.equal(s.runs[CHAT].status_.kind, 'model_loading');
  assert.deepEqual(s.runs[CHAT].warnings, ['Rate limit soon']);
  s = reduce(s, ev('ai:text_delta', { ...env(5), messageId: 'm1', blockIndex: 0, text: 'x' }));
  assert.equal(s.runs[CHAT].status_, null);
});

// --- tools ------------------------------------------------------------------

test('tool cards follow start → update → end and feed the DN registry', () => {
  let s = apply(loaded(), started(1), toolStart(2, 't1', { status: 'queued' }), ev('ai:tool_update', { ...env(3), toolCallId: 't1', status: 'running' }));
  assert.deepEqual(s.runs[CHAT].toolOrder, ['t1']);
  assert.equal(s.runs[CHAT].toolCards.t1.status, 'running');
  assert.deepEqual(s.runs[CHAT].toolCards.t1.warnings, []);
  s = reduce(s, ev('ai:tool_end', {
    ...env(4), toolCallId: 't1', status: 'ok', durationMs: 42, summary: '2 entries', result: '{"ok":true}', isError: false,
    warnings: ['value_masked'], dns: ['CN=Test Locked,OU=Lab,DC=ad,DC=example'],
  }));
  const c = s.runs[CHAT].toolCards.t1;
  assert.equal(c.status, 'ok');
  assert.equal(c.durationMs, 42);
  assert.equal(c.summary, '2 entries');
  assert.deepEqual(c.warnings, ['value_masked']);
  assert.deepEqual(s.dnRegistry[regKey('cn=test locked, ou=Lab,DC=AD,dc=example')], { profileId: 'p1', messageId: 'm1', dn: 'CN=Test Locked,OU=Lab,DC=ad,DC=example' });
});

test('tool_update for an unknown card is ignored; tool_start twice keeps one card', () => {
  let s = apply(loaded(), started(1), ev('ai:tool_update', { ...env(2), toolCallId: 'nope', status: 'running' }));
  assert.deepEqual(s.runs[CHAT].toolCards, {});
  s = apply(s, toolStart(3, 't1'), toolStart(4, 't1', { status: 'awaiting_approval' }));
  assert.deepEqual(s.runs[CHAT].toolOrder, ['t1']);
  assert.equal(s.runs[CHAT].toolCards.t1.status, 'awaiting_approval');
});

// --- approvals --------------------------------------------------------------

test('approval request → awaiting_approval; resolved → running; count selector', () => {
  let s = apply(loaded(), started(1), toolStart(2, 't1', { kind: 'write', status: 'awaiting_approval' }), approvalRequest(3, 'ap1', 't1'),
    toolStart(4, 't2', { kind: 'write', status: 'awaiting_approval' }), approvalRequest(5, 'ap2', 't2', { position: { index: 2, total: 2 } }));
  assert.equal(s.runs[CHAT].status, 'awaiting_approval');
  assert.equal(selectPendingApprovalCount(s), 2);
  assert.deepEqual(pendingApprovals(s, CHAT).map((a) => a.request.approvalId), ['ap1', 'ap2']);
  assert.deepEqual(pendingApprovals(s, OTHER), []);
  s = reduce(s, ev('ai:approval_resolved', { ...env(6), approvalId: 'ap1', toolCallId: 't1', decision: 'approved', by: 'user' }));
  assert.equal(s.runs[CHAT].status, 'awaiting_approval', 'one still waiting');
  assert.equal(selectPendingApprovalCount(s), 1);
  s = reduce(s, ev('ai:approval_resolved', { ...env(7), approvalId: 'ap2', toolCallId: 't2', decision: 'denied', by: 'user' }));
  assert.equal(s.runs[CHAT].status, 'running');
  assert.equal(selectPendingApprovalCount(s), 0);
  assert.deepEqual(s.runs[CHAT].approvals.ap2.resolved, { decision: 'denied', by: 'user', at: 1007 });
});

test('a late RespondApproval ("already_resolved") keeps the first decision and marks the card', () => {
  let s = apply(loaded(), started(1), approvalRequest(2, 'ap1', 't1'),
    ev('ai:approval_resolved', { ...env(3), approvalId: 'ap1', toolCallId: 't1', decision: 'cancelled', by: 'run' }));
  s = reduce(s, { name: 'local/approval_answered', payload: { approvalId: 'ap1', status: 'already_resolved', decision: 'cancelled', by: 'run', now: 9 } });
  assert.deepEqual(s.runs[CHAT].approvals.ap1.resolved, { decision: 'cancelled', by: 'run', at: 1003 });
  assert.equal(s.runs[CHAT].approvals.ap1.lateAnswer, true);
});

test('the user answer resolves the card even before ai:approval_resolved arrives', () => {
  let s = apply(loaded(), started(1), approvalRequest(2, 'ap1', 't1'));
  s = reduce(s, { name: 'local/approval_answered', payload: { approvalId: 'ap1', status: 'applied', decision: 'approved', by: '', now: 9 } });
  assert.deepEqual(s.runs[CHAT].approvals.ap1.resolved, { decision: 'approved', by: 'user', at: 9 });
  assert.equal(selectPendingApprovalCount(s), 0);
  // the event that follows does not overwrite the decision time with garbage
  s = reduce(s, ev('ai:approval_resolved', { ...env(3), approvalId: 'ap1', toolCallId: 't1', decision: 'approved', by: 'user' }));
  assert.equal(s.runs[CHAT].approvals.ap1.resolved.decision, 'approved');
});

test('tool_end returns the run from awaiting_approval when nothing else waits', () => {
  const s = apply(loaded(), started(1), toolStart(2, 't1', { kind: 'write' }), approvalRequest(3, 'ap1', 't1'),
    ev('ai:tool_end', { ...env(4), toolCallId: 't1', status: 'denied', durationMs: 1, summary: 'denied', result: '{}', isError: true, warnings: null, dns: null }));
  assert.equal(s.runs[CHAT].status, 'running');
});

// --- completion ---------------------------------------------------------------

test('ai:done finishes the run, cancels unresolved approvals and clears the pending send', () => {
  let s = loaded();
  s = reduce(s, { name: 'local/chats', payload: { chats: [summary()] } });
  s = reduce(s, { name: 'local/pending_send', payload: { chatId: CHAT, tempId: 'local-1', kind: 'send', text: 'q', now: 5, baseMessageId: 'a0' } });
  s = apply(s, started(1), approvalRequest(2, 'ap1', 't1'),
    ev('ai:usage', { ...env(3), step: 1, usage: {}, contextTokens: 900, contextWindow: 16384, contextPercent: 5.5, totals: { inputTokens: 900, outputTokens: 20 } }),
    ev('ai:done', { ...env(4), status: 'step_limit', durationMs: 1234, totals: {}, canContinue: true, contextEdited: false }));
  const r = s.runs[CHAT];
  assert.equal(r.status, 'step_limit');
  assert.equal(r.canContinue, true);
  assert.equal(r.usage.contextTokens, 900);
  assert.ok(!runActive(r));
  assert.deepEqual(r.approvals.ap1.resolved, { decision: 'cancelled', by: 'run', at: 1004 });
  assert.equal(s.pending[CHAT], undefined);
  assert.equal(s.chats[0].running, false);
  assert.equal(selectPendingApprovalCount(s), 0);
});

test('ai:error is kept on the run', () => {
  const s = apply(loaded(), started(1), ev('ai:error', { ...env(2), code: 'rate_limited', message: 'Slow down', retryable: true, status: 429, requestId: 'req_1' }));
  assert.equal(s.runs[CHAT].error.code, 'rate_limited');
  assert.equal(s.runs[CHAT].error.status, 429);
});

test('after ai:done the persisted tail replaces the live messages (no duplicates, no empty bubbles)', () => {
  let s = loaded();
  s = reduce(s, { name: 'local/pending_send', payload: { chatId: CHAT, tempId: 'local-1', kind: 'send', text: 'q', now: 5, baseMessageId: 'a0' } });
  s = reduce(s, { name: 'local/send_result', payload: { chatId: CHAT, tempId: 'local-1', runId: RUN, userMessageId: 'u1' } });
  assert.deepEqual(s.transcripts[CHAT].map((m) => m.id), ['u0', 'a0', 'u1'], 'temp id replaced by the persisted id');
  s = apply(s, started(1),
    ev('ai:message_started', { ...env(2), messageId: 'a1', step: 1 }),
    ev('ai:text_delta', { ...env(3), messageId: 'a1', blockIndex: 0, text: 'answer' }),
    ev('ai:done', { ...env(4), status: 'completed', finalMessageId: 'a1', durationMs: 10, totals: {}, canContinue: false, contextEdited: false }));
  assert.equal(s.runs[CHAT].liveMessages.length, 1, 'live until the tail arrives');
  s = reduce(s, { name: 'local/tail', payload: { chatId: CHAT, runId: RUN, baseMessageId: 'a0', messages: [msg('u1', 'user', 'q'), msg('a1', 'assistant', 'answer')] } });
  assert.deepEqual(s.transcripts[CHAT].map((m) => m.id), ['u0', 'a0', 'u1', 'a1']);
  assert.equal(s.runs[CHAT].liveMessages.length, 0);
  assert.equal(s.runs[CHAT].settled, true);
});

test('a tail for an older run does not clear the live messages of the current run', () => {
  let s = apply(loaded(), started(1), ev('ai:text_delta', { ...env(2), messageId: 'm1', blockIndex: 0, text: 'x' }));
  s = reduce(s, { name: 'local/tail', payload: { chatId: CHAT, runId: RUN2, baseMessageId: 'a0', messages: [] } });
  assert.equal(s.runs[CHAT].liveMessages.length, 1);
  assert.equal(s.runs[CHAT].settled, false);
});

test('mergeTail: replaces after the base; unknown base or overlap returns the tail', () => {
  const old = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c')];
  assert.deepEqual(mergeTail(old, '2', [msg('4', 'user', 'd')]).map((m) => m.id), ['1', '2', '4']);
  assert.deepEqual(mergeTail(old, '', [msg('9', 'user', 'z')]).map((m) => m.id), ['9']);
  assert.deepEqual(mergeTail(old, null, [msg('9', 'user', 'z')]).map((m) => m.id), ['9']);
  assert.deepEqual(mergeTail(old, 'gone', [msg('9', 'user', 'z')]).map((m) => m.id), ['9']);
  assert.deepEqual(mergeTail(old, '2', [msg('1', 'user', 'a'), msg('5', 'user', 'e')]).map((m) => m.id), ['1', '5'], 'whole chat returned');
});

test('a failed send removes the optimistic message', () => {
  let s = reduce(loaded(), { name: 'local/pending_send', payload: { chatId: CHAT, tempId: 'local-1', kind: 'send', text: 'q', now: 5, baseMessageId: 'a0' } });
  assert.equal(s.transcripts[CHAT].length, 3);
  s = reduce(s, { name: 'local/send_failed', payload: { chatId: CHAT, tempId: 'local-1' } });
  assert.deepEqual(s.transcripts[CHAT].map((m) => m.id), ['u0', 'a0']);
  assert.equal(s.pending[CHAT], undefined);
});

test('regenerate/edit truncate the last turn locally; continue adds a marked message', () => {
  const base = loaded([msg('u0', 'user', 'a'), msg('a0', 'assistant', 'b'), msg('u1', 'user', 'c'), msg('a1', 'assistant', 'd')]);
  let s = reduce(base, { name: 'local/pending_send', payload: { chatId: CHAT, tempId: 't', kind: 'regenerate', text: '', now: 1, baseMessageId: 'a0', truncateAfter: 'u1' } });
  assert.deepEqual(s.transcripts[CHAT].map((m) => m.id), ['u0', 'a0', 'u1']);
  s = reduce(base, { name: 'local/pending_send', payload: { chatId: CHAT, tempId: 't', kind: 'edit', text: 'c2', now: 1, baseMessageId: 'a0', truncateAfter: 'a0' } });
  assert.deepEqual(s.transcripts[CHAT].map((m) => m.id), ['u0', 'a0', 't']);
  assert.equal(s.transcripts[CHAT][2].blocks[0].text, 'c2');
  s = reduce(base, { name: 'local/pending_send', payload: { chatId: CHAT, tempId: 't', kind: 'edit', text: 'first', now: 1, baseMessageId: '', truncateAfter: null } });
  assert.deepEqual(s.transcripts[CHAT].map((m) => m.id), ['t'], 'editing the first message drops everything');
  s = reduce(base, { name: 'local/pending_send', payload: { chatId: CHAT, tempId: 't', kind: 'continue', text: 'Continue.', now: 1, baseMessageId: 'a1' } });
  assert.equal(s.transcripts[CHAT][4].blocks[0].meta.kind, 'continue');
});

test('run_started that arrives before SendMessage returns still gets the base message', () => {
  let s = reduce(loaded(), { name: 'local/pending_send', payload: { chatId: CHAT, tempId: 'local-1', kind: 'send', text: 'q', now: 5, baseMessageId: 'a0' } });
  s = reduce(s, started(1));
  assert.equal(s.runs[CHAT].baseMessageId, 'a0');
  s = reduce(s, { name: 'local/send_result', payload: { chatId: CHAT, tempId: 'local-1', runId: RUN, userMessageId: 'u1' } });
  assert.equal(s.runs[CHAT].baseMessageId, 'a0');
});

// --- re-sync (GetRunState) ------------------------------------------------------

function snapshot(over = {}) {
  return {
    chatId: CHAT, runId: RUN, status: 'awaiting_approval', kind: 'send', startedAt: 100, lastSeq: 10, baseMessageId: 'a0',
    messages: [
      msg('u1', 'user', 'unlock test.locked'),
      { id: 'a1', role: 'assistant', createdAt: 2, blocks: [{ type: 'tool_use', id: 't1', name: 'unlock_account', input: { dn: 'CN=T,DC=x' }, meta: { kind: 'write', connectionId: 'p1', connectionLabel: 'Lab' } }] },
    ],
    partial: { id: 'a2', role: 'assistant', createdAt: 3, blocks: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Waiting' }] },
    pendingApprovals: [approvalRequest(9, 'ap1', 't1').payload],
    toolStatus: { t1: 'awaiting_approval' },
    usage: null,
    ...over,
  };
}

test('GetRunState seeds the run: no event is applied twice', () => {
  let s = reduce(loaded(), { name: 'local/snapshot', payload: { snapshot: snapshot(), now: 77 } });
  const r = s.runs[CHAT];
  assert.equal(r.lastSeq, 10);
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(r.userMessageId, 'u1');
  assert.deepEqual(s.transcripts[CHAT].map((m) => m.id), ['u0', 'a0', 'u1', 'a1']);
  assert.equal(r.toolCards.t1.status, 'awaiting_approval');
  assert.equal(r.toolCards.t1.kind, 'write');
  assert.equal(r.liveMessages[0].id, 'a2');
  assert.equal(r.liveMessages[0].blocks[0].type, 'thinking');
  assert.equal(r.liveMessages[0].blocks[1].text, 'Waiting');
  assert.equal(selectPendingApprovalCount(s), 1);
  // seq 10 was already in the snapshot; 11 applies
  const same = reduce(s, ev('ai:text_delta', { ...env(10), messageId: 'a2', blockIndex: 1, text: ' twice' }));
  assert.equal(same, s);
  s = reduce(s, ev('ai:text_delta', { ...env(11), messageId: 'a2', blockIndex: 1, text: ' once' }));
  assert.equal(s.runs[CHAT].liveMessages[0].blocks[1].text, 'Waiting once');
});

test('an older snapshot never rewinds a run the store already follows', () => {
  const steps = [];
  for (let seq = 2; seq <= 12; seq++) steps.push(ev('ai:status', { ...env(seq), kind: 'compacting', message: 'x' }));
  const s = apply(loaded(), started(1), ...steps);
  assert.equal(s.runs[CHAT].lastSeq, 12);
  assert.equal(reduce(s, { name: 'local/snapshot', payload: { snapshot: snapshot(), now: 1 } }), s);
});

// --- secrets (§6.7) -------------------------------------------------------------

test('secret_available carries no value; reveal stores it in memory until expiry', () => {
  let s = apply(loaded(), started(1), ev('ai:secret_available', { ...env(2), toolCallId: 't1', kind: 'password', dn: 'CN=T,DC=x', expiresAt: 5000 }));
  assert.equal(s.secrets.t1.value, undefined);
  assert.equal(s.secrets.t1.revealed, false);
  s = reduce(s, { name: 'local/secret_revealed', payload: { toolCallId: 't1', value: 'Pw-123', expiresAt: 4000 } });
  assert.equal(s.secrets.t1.value, 'Pw-123');
  assert.equal(s.secrets.t1.expiresAt, 4000, 'the earlier expiry wins');
  assert.equal(reduce(s, { name: 'local/expire_secrets', payload: { now: 3999 } }), s);
  s = reduce(s, { name: 'local/expire_secrets', payload: { now: 4000 } });
  assert.equal(s.secrets.t1.value, undefined);
  assert.equal(s.secrets.t1.revealed, true);
});

test('a secret that could not be pulled is gone; deleting the chat drops its secrets', () => {
  let s = apply(loaded(), started(1), ev('ai:secret_available', { ...env(2), toolCallId: 't1', kind: 'password', dn: 'CN=T,DC=x', expiresAt: 5000 }));
  const gone = reduce(s, { name: 'local/secret_gone', payload: { toolCallId: 't1' } });
  assert.equal(gone.secrets.t1.expiresAt, 0);
  assert.equal(gone.secrets.t1.value, undefined);
  s = reduce(s, { name: 'local/secret_revealed', payload: { toolCallId: 't1', value: 'Pw-123', expiresAt: 4000 } });
  s = reduce(s, { name: 'local/chat_deleted', payload: { chatId: CHAT } });
  assert.deepEqual(s.secrets, {});
  assert.equal(s.runs[CHAT], undefined);
  assert.equal(s.transcripts[CHAT], undefined);
  assert.ok(!JSON.stringify(s).includes('Pw-123'));
});

// --- chats ------------------------------------------------------------------

test('chat list: sorted by updatedAt, running flag kept for active runs', () => {
  let s = apply(loaded(), started(1));
  s = reduce(s, { name: 'local/chats', payload: { chats: [{ ...summary(OTHER), updatedAt: 1 }, { ...summary(), updatedAt: 9, running: false }] } });
  assert.deepEqual(s.chats.map((c) => c.id), [CHAT, OTHER]);
  assert.equal(s.chats[0].running, true);
});

test('chat_loaded registers DNs of persisted tool results', () => {
  const s = loaded([
    { id: 'a1', role: 'assistant', createdAt: 1, blocks: [{ type: 'tool_use', id: 't1', name: 'get_entry', input: {}, meta: { connectionId: 'p9' } }] },
    { id: 'u2', role: 'user', createdAt: 2, blocks: [{ type: 'tool_result', toolUseId: 't1', content: '{}', meta: { dns: ['CN=A,DC=x'] } }] },
  ]);
  assert.deepEqual(s.dnRegistry[regKey('cn=a,dc=x')], { profileId: 'p9', messageId: 'u2', dn: 'CN=A,DC=x' });
});

test('regKey ignores case, spaces after commas and U+2060', () => {
  assert.equal(regKey('CN=Anna⁠ Schmidt, OU=Users,DC=Lab'), regKey('cn=anna schmidt,ou=users,dc=lab'));
  assert.notEqual(regKey('CN=a\\,b,DC=x'), regKey('CN=a,b,DC=x'));
});

// --- the Go contract (golden payloads) ------------------------------------------

test('every Go event of the golden contract is handled without throwing', () => {
  const golden = JSON.parse(readFileSync(new URL('../../src/types/ai.events.golden.json', import.meta.url), 'utf8'));
  const names = Object.keys(golden.events);
  assert.equal(names.length, 20);
  let s = loaded();
  s = reduce(s, { name: 'local/chats', payload: { chats: [summary()] } });
  s = reduce(s, ev('ai:run_started', { ...golden.events['ai:run_started'], chatId: CHAT, runId: RUN, seq: 1 }));
  let seq = 1;
  for (const name of names) {
    if (name === 'ai:run_started' || name === 'ai:done') continue;
    const payload = { ...golden.events[name] };
    if (isRunEvent(name)) Object.assign(payload, { chatId: CHAT, runId: RUN, seq: ++seq });
    else if ('chatId' in payload) payload.chatId = CHAT;
    s = reduce(s, ev(name, payload));
    if (isRunEvent(name)) assert.equal(s.runs[CHAT].lastSeq, seq, name + ' applied');
  }
  s = reduce(s, ev('ai:done', { ...golden.events['ai:done'], chatId: CHAT, runId: RUN, seq: ++seq }));
  assert.ok(!runActive(s.runs[CHAT]));
  assert.equal(isRunEvent('ai:chat_updated'), false);
  assert.equal(isRunEvent('ai:tool_end'), true);
});

// --- out-of-order delivery (wails dev browser clients, review fix) --------------

test('an early event waits for its predecessor and both apply in seq order', () => {
  let s = apply(loaded(), started(1));
  let r = reduceApplied(s, ev('ai:text_delta', { ...env(3), messageId: 'm1', blockIndex: 0, text: 'Hi' }));
  assert.equal(r.applied.length, 0);
  assert.equal(heldCount(r.state, CHAT), 1);
  assert.equal(r.state.runs[CHAT].lastSeq, 1);
  r = reduceApplied(r.state, ev('ai:message_started', { ...env(2), messageId: 'm1', step: 1 }));
  assert.deepEqual(r.applied.map((e) => e.name), ['ai:message_started', 'ai:text_delta']);
  assert.equal(r.state.runs[CHAT].lastSeq, 3);
  assert.equal(r.state.runs[CHAT].liveMessages[0].blocks[0].text, 'Hi');
  assert.equal(heldCount(r.state, CHAT), 0);
});

test('events before their run_started are held, including ai:done', () => {
  let s = apply(loaded(),
    ev('ai:message_started', { ...env(2), messageId: 'm1', step: 1 }),
    ev('ai:done', { ...env(3), status: 'completed', durationMs: 1, totals: {}, canContinue: false, contextEdited: false }));
  assert.equal(s.runs[CHAT], undefined);
  assert.equal(heldCount(s, CHAT), 2);
  s = reduce(s, started(1));
  assert.equal(s.runs[CHAT].lastSeq, 3);
  assert.ok(!runActive(s.runs[CHAT]), 'the early ai:done ended the run');
  assert.equal(heldCount(s, CHAT), 0);
});

test('approval_request before tool_update(awaiting_approval) still ends as awaiting approval', () => {
  let s = apply(loaded(), started(1), toolStart(2, 't1', { name: 'modify_entry', kind: 'write', status: 'queued' }), ev('ai:tool_update', { ...env(3), toolCallId: 't1', status: 'running' }));
  s = reduce(s, approvalRequest(5, 'ap1', 't1'));
  assert.equal(s.runs[CHAT].toolCards.t1.status, 'running', 'held until seq 4');
  s = reduce(s, ev('ai:tool_update', { ...env(4), toolCallId: 't1', status: 'awaiting_approval' }));
  assert.equal(s.runs[CHAT].toolCards.t1.status, 'awaiting_approval');
  assert.equal(selectPendingApprovalCount(s), 1);
});

test('a gap that never closes: flush applies the held events in order, run_gone ends the run', () => {
  let s = apply(loaded(), started(1),
    ev('ai:text_delta', { ...env(5), messageId: 'm1', blockIndex: 0, text: 'b' }),
    ev('ai:message_started', { ...env(3), messageId: 'm1', step: 1 }),
    ev('ai:text_delta', { ...env(4), messageId: 'm1', blockIndex: 0, text: 'a' }));
  assert.equal(heldCount(s, CHAT), 3);
  s = reduce(s, { name: 'local/flush_held', payload: { chatId: CHAT } });
  assert.equal(heldCount(s, CHAT), 0);
  assert.equal(s.runs[CHAT].lastSeq, 5);
  assert.equal(s.runs[CHAT].liveMessages[0].blocks[0].text, 'ab');
  assert.ok(runActive(s.runs[CHAT]));
  s = reduce(s, { name: 'local/run_gone', payload: { chatId: CHAT, now: 9 } });
  assert.ok(!runActive(s.runs[CHAT]));
  assert.equal(s.chats.find((c) => c.id === CHAT)?.running ?? false, false);
});

test('late events of a run the chat has left are dropped, not held', () => {
  let s = apply(loaded(), started(1), started(1, { runId: RUN2 }));
  s = reduce(s, ev('ai:text_delta', { ...env(7), messageId: 'm1', blockIndex: 0, text: 'late' }));
  assert.equal(heldCount(s, CHAT), 0);
  // an early event of the left run's successor still waits
  s = reduce(s, ev('ai:text_delta', { ...env(3, { runId: RUN2 }), messageId: 'm1', blockIndex: 0, text: 'x' }));
  assert.equal(heldCount(s, CHAT), 1);
});

test('the golden run events give the same state in any arrival order', () => {
  const golden = JSON.parse(readFileSync(new URL('../../src/types/ai.events.golden.json', import.meta.url), 'utf8'));
  const runEvents = [ev('ai:run_started', { ...golden.events['ai:run_started'], chatId: CHAT, runId: RUN, seq: 1 })];
  let seq = 1;
  for (const name of Object.keys(golden.events)) {
    if (name === 'ai:run_started' || name === 'ai:done' || !isRunEvent(name)) continue;
    runEvents.push(ev(name, { ...golden.events[name], chatId: CHAT, runId: RUN, seq: ++seq }));
  }
  runEvents.push(ev('ai:done', { ...golden.events['ai:done'], chatId: CHAT, runId: RUN, seq: ++seq }));
  const base = reduce(loaded(), { name: 'local/chats', payload: { chats: [summary()] } });
  const inOrder = apply(base, ...runEvents);
  const strip = (st) => ({ ...st, held: undefined });
  // reversed, odd/even interleaved and a fixed pseudo-random permutation
  let x = 7;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const shuffled = [...runEvents].map((e) => [rnd(), e]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  const orders = [
    [...runEvents].reverse(),
    [...runEvents.filter((_, i) => i % 2 === 1), ...runEvents.filter((_, i) => i % 2 === 0)],
    shuffled,
  ];
  for (const order of orders) {
    const got = apply(base, ...order);
    assert.equal(heldCount(got, CHAT), 0);
    assert.deepEqual(strip(got), strip(inOrder));
  }
});

test('a persisted read card keeps its connection from the tool_result meta (reload)', () => {
  const s = loaded([
    { id: 'a1', role: 'assistant', createdAt: 1, blocks: [{ type: 'tool_use', id: 't1', name: 'get_entry', input: {} }] },
    { id: 'u2', role: 'user', createdAt: 2, blocks: [{ type: 'tool_result', toolUseId: 't1', content: '{}', meta: { connectionId: 'p7', connectionLabel: 'Lab', dns: ['CN=B,DC=x'] } }] },
  ]);
  assert.deepEqual(s.dnRegistry[regKey('cn=b,dc=x')], { profileId: 'p7', messageId: 'u2', dn: 'CN=B,DC=x' });
  // the re-sync snapshot of a running read call takes it from there too
  const snap = snapshot({
    messages: [
      msg('u1', 'user', 'who is b'),
      { id: 'a1', role: 'assistant', createdAt: 2, blocks: [{ type: 'tool_use', id: 't9', name: 'get_entry', input: {} }] },
      { id: 'r1', role: 'user', createdAt: 3, blocks: [{ type: 'tool_result', toolUseId: 't9', content: '{}', meta: { connectionId: 'p7', connectionLabel: 'Lab' } }] },
    ],
    toolStatus: { t9: 'ok' }, pendingApprovals: [], partial: null, status: 'running',
  });
  const r = reduce(loaded(), { name: 'local/snapshot', payload: { snapshot: snap, now: 1 } });
  assert.equal(r.runs[CHAT].toolCards.t9.connectionId, 'p7');
  assert.equal(r.runs[CHAT].toolCards.t9.connectionLabel, 'Lab');
});
