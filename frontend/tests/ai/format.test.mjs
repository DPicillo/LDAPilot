// Pure UI helpers (lib/aiFormat.ts): node --test 'tests/ai/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDN, isFilter, stripWordJoiner, rdnValue, parentDN, dnKey, dnUnder, extractFilter,
  splitInvisible, showInvisible, csvFromToolResult, toCSV, looksLikePassword, utf8Length,
  classifyDestination, providerKeyOf, statusFromResult, formatRelativeTime, formatTokens, parseFacadeError, splitElapsed,
  mustChangeText,
} from '../../src/lib/aiFormat.ts';

test('DN detection: at least two attr=value RDNs, U+2060 ignored', () => {
  assert.equal(isDN('CN=Anna Schmidt,OU=Users,DC=corp,DC=test'), true);
  assert.equal(isDN('cn=admin,dc=demo,dc=ldapilot,dc=local'), true);
  assert.equal(isDN('CN=Smith\\, John,OU=Users,DC=x'), true);
  assert.equal(isDN('CN=a+UID=b,DC=x'), true);
  assert.equal(isDN('1.2.3.4=x,DC=x'), true);
  assert.equal(isDN('CN\u2060=Anna,DC\u2060=x'), true);
  assert.equal(isDN('CN=Anna'), false);
  assert.equal(isDN('a, b'), false);
  assert.equal(isDN('(cn=a,dc=b)'), false);
  assert.equal(isDN('https://x/?a=b,c=d'), false);
  assert.equal(isDN('x=,y=1'), false);
  assert.equal(stripWordJoiner('C\u2060N=a'), 'CN=a');
});

test('filter detection: balanced, starts with ( and contains =', () => {
  assert.equal(isFilter('(objectClass=user)'), true);
  assert.equal(isFilter('(&(objectClass=user)(|(cn=a*)(sn=b)))'), true);
  assert.equal(isFilter('(cn=a\\29b)'), true);
  assert.equal(isFilter('(cn=a)(sn=b)'), false);
  assert.equal(isFilter('(cn=a'), false);
  assert.equal(isFilter('(objectClass)'), false);
  assert.equal(isFilter('cn=a'), false);
});

test('DN helpers', () => {
  assert.equal(rdnValue('CN=Smith\\, John,OU=Users,DC=x'), 'Smith, John');
  assert.equal(parentDN('CN=a,OU=b,DC=c'), 'OU=b,DC=c');
  assert.equal(dnKey('CN=A, OU=B'), 'cn=a,ou=b');
  assert.equal(dnUnder('CN=a,OU=Users,DC=Corp', 'dc=corp'), true);
  assert.equal(dnUnder('CN=a,OU=Users,DC=Corpx', 'dc=corp'), false);
});

test('extractFilter takes the first balanced filter from find_accounts method text', () => {
  const m = 'filter (&(objectCategory=person)(objectClass=user)(lockoutTime>=1)), then verified per account with msDS-User-Account-Control-Computed (lockout duration)';
  assert.equal(extractFilter(m), '(&(objectCategory=person)(objectClass=user)(lockoutTime>=1))');
  assert.equal(extractFilter('domain maxPwdAge is never'), null);
});

test('invisible characters are split out and labelled', () => {
  const parts = splitInvisible('ad\u200Bmin');
  assert.deepEqual(parts.map((p) => p.invisible), [false, true, false]);
  assert.equal(showInvisible('a\u202Eb'), 'a⟨U+202E⟩b');
});

test('CSV from search_ldap, find_accounts and get_membership results', () => {
  const search = JSON.stringify({ ok: true, entries: [
    { dn: 'CN=A,DC=x', attrs: { cn: 'A', mail: ['a@x', 'a2@x'] } },
    { dn: 'CN=B\u2060,DC=x', attrs: { cn: 'B', description: 'has, comma' } },
  ] });
  // ";" is quoted too (spreadsheet locales that use it as separator)
  assert.equal(csvFromToolResult('search_ldap', search), 'dn,cn,mail,description\r\n"CN=A,DC=x",A,"a@x; a2@x",\r\n"CN=B,DC=x",B,,"has, comma"\r\n');
  const acc = JSON.stringify({ accounts: [{ dn: 'CN=T,DC=x', login: 'test.locked', name: 'T' }] });
  assert.equal(csvFromToolResult('find_accounts', acc), 'dn,login,name\r\n"CN=T,DC=x",test.locked,T\r\n');
  const mem = JSON.stringify({ items: [{ dn: 'CN=Deep User,DC=x', name: 'Deep User', type: 'user', depth: 3, via: ['CN=L2,DC=x', 'CN=L3,DC=x'] }] });
  assert.match(csvFromToolResult('get_membership', mem), /^dn,name,type,depth,via\r\n"CN=Deep User,DC=x",Deep User,user,3,"CN=L2,DC=x; CN=L3,DC=x"\r\n$/);
  assert.equal(csvFromToolResult('search_ldap', '{"entries":[]}'), null);
  assert.equal(csvFromToolResult('get_entry', search), null);
  assert.equal(csvFromToolResult('search_ldap', 'not json'), null);
  assert.equal(toCSV([['a"b']]), '"a""b"\r\n');
});

test('password-like text in the composer', () => {
  assert.equal(looksLikePassword('Set the password: Winter2026!'), true);
  assert.equal(looksLikePassword('Kennwort=abc'), true);
  assert.equal(looksLikePassword('pw: x'), true);
  assert.equal(looksLikePassword('use Xk9#mP2$vL7qR4!nB8wZ as start value'), true);
  assert.equal(looksLikePassword('Which accounts are locked out?'), false);
  assert.equal(looksLikePassword('Open CN=Anna Schmidt,OU=Users,DC=corp,DC=test please'), false);
  assert.equal(looksLikePassword('GUID 6f1c2a4e-9b8d-4c3e-a1f2-0123456789ab'), false);
  assert.equal(looksLikePassword('filter (&(objectClass=user)(sAMAccountName=Administrator2))'), false);
  assert.equal(looksLikePassword('Which password policy applies to anna?'), false);
});

test('utf8Length counts bytes', () => {
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('ä'), 2);
  assert.equal(utf8Length('€'), 3);
  assert.equal(utf8Length('😀'), 4);
});

test('destination classification mirrors permission.Classify', () => {
  assert.deepEqual(classifyDestination({ engine: 'builtin', provider: 'ollama', url: 'http://localhost:11434' }), { host: 'localhost', local: true });
  assert.equal(classifyDestination({ engine: 'builtin', provider: 'ollama', url: 'http://localhost:11434' }, true).local, false);
  assert.equal(classifyDestination({ engine: 'builtin', provider: 'openai', flavor: 'ollama', url: 'http://127.0.0.1:11434/v1' }).local, true);
  assert.equal(classifyDestination({ engine: 'builtin', provider: 'openai', flavor: 'litellm', url: 'http://localhost:4000/v1' }).local, false);
  assert.equal(classifyDestination({ engine: 'builtin', provider: 'openai', flavor: 'litellm', url: 'http://localhost:4000/v1', endpointLocal: true }).local, true);
  assert.equal(classifyDestination({ engine: 'builtin', provider: 'openai', flavor: 'openai', url: 'https://api.openai.com/v1' }).local, false);
  assert.equal(classifyDestination({ engine: 'builtin', provider: 'ollama', url: 'http://gpu-box:11434' }).local, false);
  assert.equal(classifyDestination({ engine: 'claudecode', provider: '', url: '' }).host, 'api.anthropic.com (Claude Code)');
  assert.equal(providerKeyOf({ engine: 'builtin', provider: 'openai', flavor: '' }), 'openai/custom');
  assert.equal(providerKeyOf({ engine: 'claudecode', provider: 'ollama' }), 'claudecode');
});

test('tool status of persisted calls', () => {
  const use = { type: 'tool_use', id: 't' };
  assert.equal(statusFromResult(use, { type: 'tool_result', content: '{"ok":true}' }), 'ok');
  assert.equal(statusFromResult(use, { type: 'tool_result', isError: true, content: '{"ok":false,"error":{"code":"DECLINED_BY_USER"}}' }), 'denied');
  assert.equal(statusFromResult(use, { type: 'tool_result', isError: true, content: '{"ok":false,"error":{"code":"CANCELLED"}}' }), 'cancelled');
  assert.equal(statusFromResult(use, { type: 'tool_result', isError: true, meta: { errorCode: 'STEP_LIMIT' } }), 'not_executed');
  assert.equal(statusFromResult(use, { type: 'tool_result', isError: true, content: '{"ok":false,"error":{"code":"OUTCOME_UNKNOWN"}}' }), 'outcome_unknown');
  assert.equal(statusFromResult(use, { type: 'tool_result', isError: true, content: '{"ok":false,"error":{"code":"NO_SUCH_OBJECT"}}' }), 'error');
  assert.equal(statusFromResult({ ...use, meta: { executing: true } }, undefined), 'outcome_unknown');
});

test('relative time uses milliseconds (audit 2.18)', () => {
  const now = 1_800_000_000_000;
  assert.equal(formatRelativeTime(now - 10_000, now), 'just now');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatRelativeTime(now - 26 * 3_600_000, now), 'yesterday');
  assert.equal(formatTokens(1500), '1.5k');
});

test('context-window sizes keep their binary k (2b defect 6: "16k–33k")', () => {
  // The automatic Ollama window (16k in 8k steps up to 32k) and model cards.
  assert.equal(formatTokens(16384), '16k');
  assert.equal(formatTokens(24576), '24k');
  assert.equal(formatTokens(32768), '32k');
  assert.equal(formatTokens(8192), '8k');
  assert.equal(formatTokens(131072), '128k');
  assert.equal(formatTokens(262144), '256k');
  assert.equal(formatTokens(1048576), '1M');
  assert.equal(`${formatTokens(16384)}–${formatTokens(32768)}`, '16k–32k');
  // Decimal sizes and ordinary counts stay decimal.
  assert.equal(formatTokens(128000), '128k');
  assert.equal(formatTokens(200000), '200k');
  assert.equal(formatTokens(1_000_000), '1M');
  assert.equal(formatTokens(32760), '33k');
  assert.equal(formatTokens(4100), '4.1k');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(undefined), '0');
});

test('facade errors "code: message" are split', () => {
  assert.deepEqual(parseFacadeError(new Error('run_active: a response is still running')), { code: 'run_active', message: 'a response is still running' });
  assert.deepEqual(parseFacadeError('Settings were changed elsewhere (x). Reload'), { code: '', message: 'Settings were changed elsewhere (x). Reload' });
});

test('splitElapsed reads the Go duration at the end of a status message', () => {
  assert.deepEqual(splitElapsed('The model is reading the conversation… (18s)'), { text: 'The model is reading the conversation…', elapsedMs: 18000 });
  assert.deepEqual(splitElapsed('Loading qwen3-vl:8b… (1m3s)'), { text: 'Loading qwen3-vl:8b…', elapsedMs: 63000 });
  assert.equal(splitElapsed('Loading qwen3-vl:8b… (1h0m0s)').elapsedMs, 3600000);
  assert.equal(splitElapsed('Loading qwen3-vl:8b…'), null);
  assert.equal(splitElapsed('Compacting (step 2)'), null);
});

test('reset card: on 389 DS the server password policy decides "must change" (2b defect 2)', () => {
  assert.equal(mustChangeText({ mustChange: true }, '389ds'), 'at next logon (server password policy)');
  assert.equal(mustChangeText({ mustChange: false }, '389ds'), 'decided by the server password policy');
  assert.equal(mustChangeText({ mustChange: true }, 'openldap'), 'at next logon');
  assert.equal(mustChangeText({ mustChange: false }, 'ad'), 'no');
  assert.equal(mustChangeText({ mustChange: false }), 'no');
});

test('rdnValue decodes hex escapes (chip labels)', () => {
  assert.equal(rdnValue('CN=Semi\\3BColon \\3CAngle\\3E,OU=Special Cases,DC=x'), 'Semi;Colon <Angle>');
  assert.equal(rdnValue('cn=J\\C3\\BCrgen,dc=x'), 'Jürgen');
  assert.equal(rdnValue('CN=\\#Hash User,DC=x'), '#Hash User');
  assert.equal(rdnValue('CN=Plain,DC=x'), 'Plain');
});
