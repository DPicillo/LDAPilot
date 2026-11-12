// Claude Code engine settings: where the CLI runs (Windows / WSL).
// node --test 'tests/ai/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicEnvHint, CC_RUNTIMES, ccRuntimeHint, distroOptions, locationText } from '../../src/lib/aiClaudeCode.ts';

test('runtime choices and their hints', () => {
  assert.deepEqual(CC_RUNTIMES.map((o) => o.value), ['', 'windows', 'wsl']);
  assert.match(ccRuntimeHint(''), /installed in Windows is used; without one, LDAPilot looks in WSL/);
  assert.match(ccRuntimeHint('windows'), /Only a Claude Code installed in Windows/);
  assert.match(ccRuntimeHint('wsl'), /own login there/);
  assert.match(ccRuntimeHint('wsl'), /nothing listens outside its loopback/);
});

test('distribution choices: default first, versions, a configured one that is gone', () => {
  const wsl = { available: true, distros: [{ name: 'Ubuntu', default: true, version: 2 }, { name: 'Legacy', version: 1 }, { name: 'Alpine' }] };
  assert.deepEqual(distroOptions(wsl, ''), [
    { value: '', label: 'Default distribution (Ubuntu)' },
    { value: 'Ubuntu', label: 'Ubuntu · WSL 2' },
    { value: 'Legacy', label: 'Legacy · WSL 1' },
    { value: 'Alpine', label: 'Alpine' },
  ]);
  const gone = distroOptions(wsl, 'Debian');
  assert.deepEqual(gone.at(-1), { value: 'Debian', label: 'Debian (not installed)' });
  // Not listed yet (or WSL missing): the default entry and the configured one.
  assert.deepEqual(distroOptions(undefined, 'Debian'), [{ value: '', label: 'Default distribution' }, { value: 'Debian', label: 'Debian (not installed)' }]);
  assert.deepEqual(distroOptions({ available: false, distros: null, error: 'WSL is not installed' }, ''), [{ value: '', label: 'Default distribution' }]);
});

test('where the CLI was found', () => {
  assert.equal(locationText(undefined, 'windows'), '');
  assert.equal(locationText({ runtime: 'native', path: 'C:\\Users\\a\\.local\\bin\\claude.exe' }, 'windows'), 'Found in Windows: C:\\Users\\a\\.local\\bin\\claude.exe');
  assert.equal(locationText({ runtime: 'native', path: '/usr/local/bin/claude' }, 'linux'), 'Found: /usr/local/bin/claude');
  assert.equal(
    locationText({ runtime: 'wsl', path: '/home/a/.nvm/versions/node/v22.11.0/bin/claude', distro: 'Ubuntu', wslVersion: 2, envSource: 'login' }, 'windows'),
    'Found in WSL 2 · Ubuntu: /home/a/.nvm/versions/node/v22.11.0/bin/claude (environment of the login shell)',
  );
  assert.match(locationText({ runtime: 'wsl', path: '/usr/bin/claude', distro: 'Debian', envSource: 'plain' }, 'windows'), /^Found in WSL · Debian: \/usr\/bin\/claude \(environment of \/bin\/sh/);
});

test('the Anthropic environment hint names the WSL shell in WSL mode', () => {
  assert.equal(anthropicEnvHint(false), 'Passes ANTHROPIC_* and the Claude Code login/backend variables (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY, CLAUDE_CODE_SKIP_*_AUTH) to Claude Code. Off: only a `claude login` session works.');
  assert.match(anthropicEnvHint(true), /of your login shell in WSL/);
  assert.match(anthropicEnvHint(true), /session in that distribution works/);
});
